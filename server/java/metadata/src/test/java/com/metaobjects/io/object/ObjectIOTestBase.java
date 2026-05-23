package com.metaobjects.io.object;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.*;
import com.metaobjects.io.MetaDataIOException;
import com.metaobjects.io.object.json.JsonObjectReader;
import com.metaobjects.io.object.json.JsonObjectWriter;
//import com.metaobjects.io.object.xml.XMLObjectReader;
//import com.metaobjects.io.object.xml.XMLObjectWriter;
//import com.metaobjects.io.xml.XMLIOConstants;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.AbstractObjectRepresentation;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ValueMetaObject;
import com.metaobjects.object.value.ValueObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.*;
import java.util.ArrayList;
import java.util.List;

public abstract class ObjectIOTestBase {

    protected MetaDataLoader loader = null;
    
    public final static class MD {
        static String ID="id";
        static String NAME="name";
        static String OBJ_BASKET ="basket";
        static String OBJ_FRUIT ="fruit";
        static String OBJ_BUG ="bug";
        static String BASKET_FRUITS="fruits";
        static String BASKET_HOLDS="holds";
        static String FRUIT_BUG="bug";
        static String FRUIT_HAS="has";
        static String FRUIT_IN_BASKET ="inBasket";
    }

    protected File getTestFilePath() {
        File f = new File( "./target/tests");
        if ( !f.exists()) f.mkdirs();
        return f;
    }

    protected OutputStream getTestFileOutputStream(String name) throws IOException {
        File f = new File( getTestFilePath(), name );
        f.createNewFile();
        return new FileOutputStream( f );
    }

    protected InputStream getTestFileInputStream(String name) throws FileNotFoundException {
        File f = new File( getTestFilePath(), name );
        return new FileInputStream( f );
    }

    protected Reader getTestFileReader(String name) throws FileNotFoundException {
       return new InputStreamReader( getTestFileInputStream( name ));
    }

    protected Writer getTestFileWriter(String name) throws IOException {
        return new OutputStreamWriter( getTestFileOutputStream(name));
    }

    @Before
    public void setup() {
        MetaDataLoader tempLoader = MetaDataLoader.createManual( false, "json-ValueObject-io-test" );
        tempLoader.init();
        tempLoader.register();
        
        // Create basket object. @allowExtensions lets the map-backed ValueObject accept
        // dynamically-set keys (e.g. the nested fruits list), matching the old free-form behavior.
        ValueMetaObject basket = ValueMetaObject.create(MD.OBJ_BASKET);
        basket.addChild(BooleanAttribute.create(AbstractObjectRepresentation.ATTR_ALLOWEXTENSIONS, true));
        basket.addChild(IntegerField.create( MD.ID, 1 ));
        basket.addChild(StringField.create( MD.NAME, null ));
        
        ObjectField basketFruitsField = ObjectField.create( MD.BASKET_FRUITS );
        basketFruitsField.addChild(StringAttribute.create(MetaObject.ATTR_OBJECT_REF, MD.OBJ_FRUIT));
        basketFruitsField.addChild(BooleanAttribute.create("isArray", true));
        basket.addChild(basketFruitsField);
        
        tempLoader.getRoot().addChild(basket);
        
        // Create fruit object
        ValueMetaObject fruit = ValueMetaObject.create("fruit");
        fruit.addChild(BooleanAttribute.create(AbstractObjectRepresentation.ATTR_ALLOWEXTENSIONS, true));
        fruit.addChild(IntegerField.create( MD.ID, 1 ));
        fruit.addChild(StringField.create( MD.NAME, null ));
        fruit.addChild(BooleanField.create( MD.FRUIT_IN_BASKET, false ));
        
        ObjectField fruitBugField = ObjectField.create(MD.FRUIT_BUG);
        fruitBugField.addChild(StringAttribute.create(MetaObject.ATTR_OBJECT_REF, MD.OBJ_BUG));
        fruit.addChild(fruitBugField);
        
        tempLoader.getRoot().addChild(fruit);
        
        // Create bug object
        ValueMetaObject bug = ValueMetaObject.create(MD.OBJ_BUG);
        bug.addChild(BooleanAttribute.create(AbstractObjectRepresentation.ATTR_ALLOWEXTENSIONS, true));
        bug.addChild(IntegerField.create( MD.ID, 1 ));
        bug.addChild(StringField.create( MD.NAME, null ));
        
        tempLoader.getRoot().addChild(bug);
        
        loader = tempLoader.getLoader();
    }

    @After
    public void tearDown() {
        if (loader != null) {
            loader.destroy();
            loader = null;
        }
    }

    protected ValueObject createBasket(int id, String name ) {
        ValueObject o = (ValueObject) loader.getMetaObjectByName( MD.OBJ_BASKET).newInstance();
        o.put( MD.ID, id );
        o.put( MD.NAME, name);
        return o;
    }

    protected ValueObject createFruit(int id, String name ) {
        ValueObject o = (ValueObject) loader.getMetaObjectByName( MD.OBJ_FRUIT).newInstance();
        o.put( MD.ID, id );
        o.put( MD.NAME, name);
        return o;
    }

    protected ValueObject createBug(int id, String name ) {
        ValueObject o = (ValueObject) loader.getMetaObjectByName( MD.OBJ_BUG).newInstance();
        o.put( MD.ID, id );
        o.put( MD.NAME, name);
        return o;
    }

    protected void addToBasket(ValueObject b, ValueObject f ) {
        List<Object> objects = (List<Object>) b.get( MD.BASKET_FRUITS);
        if ( objects == null ) {
            objects = new ArrayList<>();
            b.put( MD.BASKET_FRUITS, objects );
        }
        objects.add( f );
        f.put( MD.FRUIT_IN_BASKET, true );
    }

    @Test
    public void testFruit() throws IOException, MetaDataIOException {

        ValueObject o = createFruit( 1, "apple" );
        runTest( o, "fruit");
    }

    @Test
    public void testBasket() throws IOException, MetaDataIOException {

        ValueObject o = createBasket( 10, "longaberger" );
        runTest(o, "basket");
    }

    @Test
    public void testFruitInBasket() throws IOException, MetaDataIOException {

        ValueObject a = createFruit( 1, "apple" );
        ValueObject b = createBasket( 10, "longaberger" );
        addToBasket( b, a );

        runTest(b, "inbasket");
    }

    @Test
    public void testFruitInBasket2() throws IOException, MetaDataIOException {

        ValueObject b = createBasket( 10, "longaberger" );
        addToBasket( b, createFruit( 1, "apple" ) );
        addToBasket( b, createFruit( 2, "orange" ) );
        addToBasket( b, createFruit( 3, "pear" ) );

        runTest(b, "inbasket2");
    }

    @Test
    public void testFruitInBasketWithBugs() throws IOException, MetaDataIOException {

        ValueObject b = createBasket( 10, "longaberger" );
        addToBasket( b, createFruit( 1, "apple" ) );
        addToBasket( b, createFruit( 2, "orange" ) );
        addToBasket( b, createFruit( 3, "pear" ) );

        ValueObject banana = createFruit( 3, "banana" );
        banana.put( "bug", createBug( 100, "fly"));
        addToBasket( b, banana );

        runTest(b, "inbasketbugs");
    }

    protected abstract void runTest(ValueObject o, String name ) throws IOException, MetaDataIOException;

    /*protected void writeXML( String filename, Object vo ) throws IOException, MetaDataIOException {

        XMLObjectWriter writer = new XMLObjectWriter( loader, getTestFileOutputStream( filename ) );
        //writer.withIndent(true);
        writer.write( vo );
        writer.close();
    }

    protected ValueObject readXML(String filename, MetaObject mo) throws IOException, MetaDataIOException {

        XMLObjectReader reader = new XMLObjectReader( loader, getTestFileInputStream( filename ) );
        ValueObject vo = (ValueObject) reader.read( mo );
        reader.close();
        return vo;
    }*/

    protected void writeJson( String filename, Object vo ) throws IOException, MetaDataIOException {

        JsonObjectWriter writer = new JsonObjectWriter( loader, getTestFileWriter( filename ) );
        writer.withPrettyPrint();
        writer.write( vo );
        writer.close();
    }

    protected ValueObject readJson(String filename, MetaObject mo ) throws IOException, MetaDataIOException {

        JsonObjectReader reader = new JsonObjectReader( loader, getTestFileReader( filename ) );
        ValueObject vo = (ValueObject) reader.read(mo);
        reader.close();
        return vo;
    }
}

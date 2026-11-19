variable "dev_url" {
  type = string
}

env "ci" {
  src = "file://atlas/schema.sql"
  dev = var.dev_url
  migration {
    dir = "file://atlas/migrations"
  }
}

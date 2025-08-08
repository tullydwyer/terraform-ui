module "example" {
  source = "./tfm-example"
  name = local_file.file_1.content
}

resource "local_file" "file_1" {
  content  = "name_1"
  filename = "out/file1.bar"
}

resource "local_file" "file_2" {
  content  = "name_2"
  filename = "out/fil2.bar"
}